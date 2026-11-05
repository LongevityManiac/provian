import { assertServerNonceWriterActive } from '../../onchain/server-writer-cutover';
import { CanonicalWallet } from '../../onchain/canonical-wallet';
/**
 * settlement runtime — THE OPERATOR RUNTIME. The one place in the relay that builds a settlement signer.
 *
 * ── WHAT CHANGED, SAID PLAINLY ────────────────────────────────────────────────
 * Until M7 the settlement entrypoint was a script and the relay built no signer at all. That
 * posture is now deliberately relaxed: an operator needs to run settlement and the epoch keeper
 * without a laptop, and the keeper in particular MUST run on a timer or scheduled policy never
 * applies and every batch after a 7-day boundary reverts. So the capability exists in the
 * relay, in exactly one module, named in `mint-capability-guard.ts::SANCTIONED_MINT_SIGNER_FILES`,
 * and `judgeMintCapability` reports `capability_closed: false` because it IS open.
 *
 * ── WHAT STILL STANDS BETWEEN THIS AND A MINT ────────────────────────────────
 * 1. `PVT9_SETTLEMENT_ARMED` must be exactly `yes-settle-real-pvt`. No default, no boolean
 * coercion, no truthy value that could arrive from a template or a copied env file.
 * 2. Both keys must be present, and they are Secret Manager mounts — never repo, never
 * plaintext in a deploy command.
 * 3. The settlement route runs TWO ways (corrected here — the earlier "operator only"
 * wording predated the weekly cron and misled a later reader): (a) SCHEDULER auth — the
 * daily runner `provian-pvt9-settlement` (`0 12 * * *`, ; the Genesis-only
 * daily pass `provian-pvt9-genesis-settlement` is the second scheduler) fires it UNATTENDED, idempotent by
 * `claim_key` so a retry cannot double-mint; (b) OPERATOR auth AND the arming token echoed in
 * the request body — the manual hand-run. An env var alone cannot fire a hand-run; a request
 * alone cannot; and `PVT9_SETTLEMENT_ARMED` (point 1) stands above BOTH paths.
 * 4. The route IS scheduled (per 3a) and runs BOTH lanes inside `runSettlement`. The epoch
 * keeper is separately scheduled (every 20 minutes) and cannot mint: `openNextEpoch` has no modifier,
 * moves no value, and is permissionless by design. The STANDARD lane still mints nothing
 * until a post-cut-line eligible PE exists AND the recon gate is admitted (the gated deploy,
 *) — those are upstream-supply/gate conditions, NOT a missing scheduler.
 *
 * ── KEY HANDLING ─────────────────────────────────────────────────────────────
 * Keys are read from the environment ONCE, here, into `Wallet` objects that never leave this
 * module's callers. Nothing logs a key, derives a key into a report, or writes one anywhere.
 * The two names are deliberately distinct from `PVT_MINTER_KEY`, which stays signer-free: the
 * SECRET behind `PVT9_SETTLEMENT_MINTER_KEY` is the same `pvt-minter-key`, but the env name
 * carrying it into a signer is separate so the guard's sweep and this posture stay legible.
 */

import { randomUUID } from 'crypto';
import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import { PVT9_BASE_CONFIG } from '../pvt9-base-config.generated';
import { evaluateCapClock, type CapClockVerdict } from './cap-clock';
import {
  loadInletCursor,
  runClaimInlet,
  saveInletCursor,
  type ClaimInletReport,
} from './claim-inlet';
import { resolveEffectiveCycleId } from './cycle-supersede';
import type { Firestore } from 'firebase-admin/firestore';
import { createMeterClaimVerifier, runMeterClaimInlet, type MeterInletReport } from '../../meter/meter-settlement';
import { payeeSettlementDue, standardSettlementIntervalDays } from './payee-settlement-interval';
import { isMeterClaimKey } from '../../meter/meter-claims';
import { createAttestationTopupInletSource } from './attestation-topup-inlet-source';
import {
  createFirestoreCandidateSource,
  createFirestoreInletSource,
} from './claim-inlet-source';
import {
  createGenesisAnchorResolver,
  createGenesisInletSource,
} from './genesis-inlet-source';
import {
  DEFAULT_EPOCH_LAG_GRACE_SEC,
  runEpochKeeper,
  type EpochKeeperChain,
  type EpochKeeperReport,
  type EpochOpenOutcome,
} from './epoch-keeper';
import type { EpochClockObservation } from './epoch-orchestration';
import {
  KERNEL_OBSERVATION_ABI,
  assertEndpointChainId,
  createProductionApprover,
  createProductionChainAdapter,
  readCapClockObservation,
} from './settlement-chain-adapter';
import {
  PLAN_INITIAL_CYCLE_MAX_FEE_WEI,
  PLAN_INITIAL_CYCLE_MAX_TRANSACTIONS,
  reconcileStrandedSettlements,
  runSettlementCycle,
  type CycleRunnerConfig,
  type CycleRunnerDeps,
  type CycleRunReport,
  type ReconciliationReport,
} from './settlement-cycle-runner';
import {
  judgeStandardLaneAdmission,
  readPublishedReconciliationReport,
  type StandardLaneAdmission,
} from './standard-lane-recon-gate';
import { DEPLOYED_TREE_GIT_HEAD } from '../tree-stamp.generated';
import {
  acquireSignerLease,
  releaseSignerLease,
  retireNeverBroadcastOrphans,
  type SettlementDb,
} from './durable-settlement-store';
import {
  readAgreedBaseBlockHash,
  readAgreedBaseHead,
  readAgreedBaseSafeHead,
} from '../../onchain/economic-discovery';

/** The exact arming token. Awkward on purpose; nothing coerces to it. */
export const ARMING_TOKEN = 'yes-settle-real-pvt';

/** Distinct from `PVT_MINTER_KEY` on purpose — that name must stay signer-free. */
export const MINTER_KEY_ENV = 'PVT9_SETTLEMENT_MINTER_KEY';
export const APPROVER_KEY_ENV = 'PVT9_SETTLEMENT_APPROVER_KEY';
export const ARMED_ENV = 'PVT9_SETTLEMENT_ARMED';
export const RPC_ENV = 'BASE_RPC_URL';

/** The kernel's `openNextEpoch()`. The only write signature this module holds. */
const EPOCH_KEEPER_ABI = ['function openNextEpoch() returns (bytes32)'] as const;

export type RuntimeRefusal =
  | 'pvt9_not_configured'
  | 'rpc_not_configured'
  | 'not_armed'
  | 'minter_key_absent'
  | 'approver_key_absent'
  | 'approver_unfunded'
  | 'epoch_verifier_absent'
  | 'cycle_unresolved_batches'
  | 'cycle_supersede_limit'
  // another run holds this signer's settlement lease.
  | 'settlement_run_in_progress'
  // — an on-demand payout must name one payee and its request.
  | 'payout_payee_invalid'
  | 'payout_request_id_invalid';

export class OperatorRefusal extends Error {
  constructor(readonly reason: RuntimeRefusal, message: string) {
    super(message);
    this.name = 'OperatorRefusal';
  }
}

export interface Pvt9Target {
  readonly kernelAddress: string;
  readonly chainId: bigint;
  readonly rpcUrl: string;
}

/**
 * Resolve the deployed kernel and the RPC, with no key involved.
 *
 * Separated from key resolution so the read-only paths — the cap clock, a dry-run inlet, the
 * epoch keeper's OBSERVATION — never touch a secret to answer a question that needs none.
 */
export function resolvePvt9Target(env: NodeJS.ProcessEnv = process.env): Pvt9Target {
  const pvt9 = PVT9_BASE_CONFIG.assets.pvt9 as {
    address: string | null; deployment_status: string;
  };
  if (pvt9.address === null || pvt9.deployment_status !== 'deployed') {
    throw new OperatorRefusal(
      'pvt9_not_configured',
      'PVT9 is not configured in this runtime (config/pvt9-base.json). Nothing to settle against.',
    );
  }
  const rpcUrl = env[RPC_ENV];
  if (rpcUrl === undefined || rpcUrl.trim() === '') {
    throw new OperatorRefusal('rpc_not_configured', `${RPC_ENV} is not set.`);
  }
  return {
    kernelAddress: pvt9.address,
    chainId: BigInt(PVT9_BASE_CONFIG.network.chain_id),
    rpcUrl,
  };
}

/** Public-chain reader for legacy interval-clock initialization; holds no signer. */
export function legacySettlementTimeReader(): (batch: import('./durable-settlement-store').SettlementBatchDoc) => Promise<number | null> {
  const target = resolvePvt9Target();
  const provider = new JsonRpcProvider(target.rpcUrl, Number(target.chainId), { staticNetwork: true });
  return async batch => {
    await assertEndpointChainId(provider, target.chainId);
    if (!batch.confirmed_tx_hash) throw new Error('payee_clock_legacy_receipt_missing');
    const receipt = await provider.getTransactionReceipt(batch.confirmed_tx_hash);
    if (!receipt || receipt.status !== 1 || !receipt.to) throw new Error('payee_clock_legacy_receipt_invalid');
    if (receipt.to.toLowerCase() !== target.kernelAddress.toLowerCase()) {
      const historical = PVT9_BASE_CONFIG.validation.forbidden_pvt_addresses as readonly string[];
      if (historical.some(address => address.toLowerCase() === receipt.to!.toLowerCase())) return null;
      throw new Error('payee_clock_legacy_receipt_target_unknown');
    }
    const safe = await readAgreedBaseSafeHead();
    const hash = await readAgreedBaseBlockHash(receipt.blockNumber);
    if (safe === null || receipt.blockNumber > safe.number || hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error('payee_clock_legacy_receipt_not_final');
    const block = await provider.getBlock(receipt.blockHash);
    if (!block || block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error('payee_clock_legacy_block_missing');
    return block.timestamp * 1000;
  };
}

/** Whether the environment carries the exact arming token. Nothing else is armed. */
export function isArmed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ARMED_ENV] === ARMING_TOKEN;
}

// ---------------------------------------------------------------------------
// The epoch keeper's chain port
// ---------------------------------------------------------------------------

/**
 * Build the keeper's chain access.
 *
 * SIGNED BY THE APPROVER EOA, NOT THE MINTER — and that is a correctness choice, not a
 * preference. `settlement-cycle-runner.ts` owns the MINTER's nonce durably: it records each
 * attempt against an allocated nonce so a crash can resume without double-spending one. An
 * out-of-band `openNextEpoch()` from the same address, landing mid-cycle, consumes a nonce the
 * runner believes it owns and desynchronises that ledger. The approver's nonce is derived
 * per-call by ethers, so the worst a collision costs there is one refused approval, which the
 * approval gate already fails closed on.
 */
export function createEpochKeeperChain(params: {
  readonly target: Pvt9Target;
  readonly signer: Wallet;
  readonly log?: (message: string) => void;
}): EpochKeeperChain {
  const provider = new JsonRpcProvider(params.target.rpcUrl, Number(params.target.chainId), {
    staticNetwork: true,
  });
  const signer = params.signer.connect(provider);
  const reader = new Contract(
    params.target.kernelAddress,
    KERNEL_OBSERVATION_ABI as unknown as string[],
    provider,
  );
  const writer = new Contract(
    params.target.kernelAddress,
    EPOCH_KEEPER_ABI as unknown as string[],
    signer,
  );

  return {
    async observe(): Promise<EpochClockObservation> {
      await assertEndpointChainId(provider, params.target.chainId);
      const block = await provider.getBlock('latest');
      if (block === null) throw new Error('epoch-keeper: latest block unavailable');
      return {
        epochZeroArmed: Boolean(await reader.epochZeroArmed()),
        epochZeroStartsAtSec: Number(await reader.epochZeroStartsAt()),
        lastOpenedEpoch: Number(await reader.lastOpenedEpoch()),
        // CHAIN time, never a local clock: the kernel evaluates `block.timestamp`.
        observedAtSec: Number(block.timestamp),
      };
    },

    async openNextEpoch(expectedEpoch: number): Promise<EpochOpenOutcome> {
      try {
        // Simulated first. A revert costs gas; a `staticCall` costs nothing and tells us
        // whether the epoch is genuinely not ready yet (the ordinary case six days out of
        // seven) before a transaction is signed.
        await writer.openNextEpoch.staticCall();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { kind: 'refused', reason: `simulation: ${message.slice(0, 200)}`, txHash: null };
      }
      try {
        params.log?.(`epoch-keeper: sending openNextEpoch() for epoch ${expectedEpoch}`);
        const tx = await writer.openNextEpoch();
        const receipt = await tx.wait();
        if (receipt === null || receipt.status !== 1) {
          return { kind: 'refused', reason: 'transaction reverted', txHash: tx.hash };
        }
        return { kind: 'opened', txHash: tx.hash };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { kind: 'refused', reason: message.slice(0, 200), txHash: null };
      }
    },
  };
}

/**
 * A worker id that is UNIQUE PER INVOCATION.
 *
 * This used to be the constant `'pvt9-epoch-keeper'`, and the only caller
 * (`routes/pvt9-operations.ts`) supplies none — so every process and every invocation presented
 * the identical owner string, `live && existing.owner !== params.workerId` was never true, and
 * the single-flight lease could not refuse anybody. `stopReason: 'lease_held'` was unreachable
 * in production. A guard that cannot fail is the defect this repo keeps finding, and the
 * keeper's own tests missed it because they proved the refusal with a DIFFERENT hard-coded id
 * ('other-worker') — a shape production never produces.
 *
 * The cost of uniqueness is that a crashed keeper no longer re-acquires its own lease on
 * restart; it waits out the TTL instead. That is the right trade here and only here: the keeper
 * holds no durable nonce state (unlike the settlement cycle, where same-worker re-acquire is
 * load-bearing), the lease TTL is 10 minutes, the schedule is every 20, and epochs are weekly.
 * The worst case is one skipped cycle.
 */
export function newKeeperWorkerId(): string {
  return `pvt9-epoch-keeper:${randomUUID()}`;
}

export interface EpochKeeperRunOptions {
  readonly db: SettlementDb;
  readonly env?: NodeJS.ProcessEnv;
  readonly workerId?: string;
  readonly maxCallsPerRun?: number;
  readonly log?: (message: string) => void;
}

export interface EpochKeeperRunResult {
  readonly keeper: EpochKeeperReport;
  readonly capClock: CapClockVerdict;
  readonly signer: string;
}

/**
 * Run the epoch keeper end to end.
 *
 * NOT gated on `PVT9_SETTLEMENT_ARMED`. Deliberate: `openNextEpoch()` cannot mint, cannot move
 * value, and cannot be aimed at the wrong epoch — the kernel derives the epoch itself. Arming
 * exists to gate ISSUANCE. Gating epoch advance on it would mean an operator who has not armed
 * settlement silently loses the epoch clock too, which is the failure this keeper was built to
 * end. It DOES require the approver key, because a transaction needs a gas payer.
 */
export async function runEpochKeeperRuntime(
  options: EpochKeeperRunOptions,
): Promise<EpochKeeperRunResult> {
  const env = options.env ?? process.env;
  const target = resolvePvt9Target(env);
  const approverKey = env[APPROVER_KEY_ENV];
  if (approverKey === undefined || approverKey.trim() === '') {
    throw new OperatorRefusal(
      'approver_key_absent',
      `${APPROVER_KEY_ENV} is not set; the epoch keeper needs a gas payer.`,
    );
  }

  const signer = new CanonicalWallet(approverKey);
  const chain = createEpochKeeperChain({ target, signer, log: options.log });
  const keeper = await runEpochKeeper(
    { db: options.db, chain, now: () => Date.now(), log: options.log },
    {
      workerId: options.workerId ?? newKeeperWorkerId(),
      // 14 covers a keeper that was down for a full quarter and still bounds one run's gas.
      maxCallsPerRun: options.maxCallsPerRun ?? 14,
      lagGraceSec: DEFAULT_EPOCH_LAG_GRACE_SEC,
      leaseTtlMs: 10 * 60 * 1000,
    },
  );

  // Read AFTER the keeper: opening an epoch is exactly what can flip the cap mode from
  // Automatic to a scheduled Fixed, and reporting the pre-run verdict would keep alarming
  // about a clock this very run retired.
  const capClock = evaluateCapClock(await readCapClockObservation(target));

  return { keeper, capClock, signer: signer.address };
}

// ---------------------------------------------------------------------------
// The settlement run
// ---------------------------------------------------------------------------

/**
 * Which lane a run SETTLES (; then made BOTH lanes daily;
 * returned the standard lane to weekly)
 * (the standing rule). A scoped run still registers BOTH inlets (registration is
 * idempotent and settles nothing), but the settlement cycle only mints the scoped
 * lane; the other lane's registered rows wait, untouched, for their own cadence.
 * 'both' is the default and preserves the unscoped run's behavior exactly.
 */
export type SettlementLaneScope = 'both' | 'genesis' | 'standard';

export interface SettlementRunOptions {
  readonly db: SettlementDb;
  readonly env?: NodeJS.ProcessEnv;
  /** Run the inlet and report what WOULD settle. Reads no key and sends nothing. */
  readonly dryRun?: boolean;
  readonly log?: (message: string) => void;
  readonly now?: () => number;
  /** The lane to SETTLE this run. Default 'both' (the operator-invoked run, ). */
  readonly lane?: SettlementLaneScope;
  /**
   * — an on-demand payout: settle ONLY this payee's standard-lane claims (lowercase
   * address). The global inlets are skipped (this payee's meter claims are registered alone) and
   * the cycle runs under its own id (`<epoch>-<day>-payout-<request>`), so it never consumes the
   * scheduled run's cycle or any other payee's rows.
   */
  readonly payee?: { readonly address: string; readonly requestId: string };
}

export interface SettlementRunResult {
  readonly standardInlet: ClaimInletReport;
  readonly genesisInlet: ClaimInletReport;
  /** the additive attestation top-up inlet (standard lane, distinct claim kind). */
  readonly topupInlet: ClaimInletReport;
  /** PE METER: pending claims from accepted batches registered as standard-lane ledger rows. */
  readonly meterInlet?: MeterInletReport;
  /** the standard-lane first-mint gate verdict for this run. */
  readonly standardLaneAdmission: StandardLaneAdmission;
  readonly capClock: CapClockVerdict | null;
  readonly settlement: CycleRunReport | null;
  readonly dryRun: boolean;
  /** which lane this run settled. */
  readonly lane: SettlementLaneScope;
  /**
   * the reconciliation run BEFORE the day's cycle was chosen. It resolves most of what
   * a run reconciles, so the cycle's own report alone would under-report it (and miss alarms).
   */
  readonly preCycleReconciliation?: ReconciliationReport | null;
}

const INLET_CONFIG = { pageSize: 200, maxPesPerRun: 25_000, maxRunMs: 10 * 60 * 1000 };

/** The plan's per-batch claim ceiling (§settlement runtime). The default; never exceeded by an override. */
export const SETTLEMENT_MAX_CLAIMS_DEFAULT = 1_000;
export const MAX_CLAIMS_OVERRIDE_ENV = 'PVT9_SETTLEMENT_MAX_CLAIMS_OVERRIDE';

/**
 * Operating-parameter override for the per-batch CLAIM ceiling — NOT economics.
 *
 * A settlement batch groups a contributor's claims; grouping never changes a mint AMOUNT,
 * PAYEE, or mint-once — the kernel applies its per-recipient floor per batch, so a split
 * costs a contributor at most (N-1) wei across N slices (deterministic, kernel-enforced;
 * `planSettlementBatches`). An operator may LOWER this to split a contributor's claims
 * across more, smaller settle transactions — to exercise the WS1 between-batch cursor-reflect
 * path against real backlog, or to shrink a batch that models over the block gas limit.
 *
 * Bounded to [1, SETTLEMENT_MAX_CLAIMS_DEFAULT]: an override can only make batches SMALLER
 * than the reviewed default, never larger; anything unset, unparseable, or out of range falls
 * back to the default. `maxRecipients`/`maxGas` are unaffected — the kernel's own recipient
 * ceiling and the block gas limit still bound a batch.
 */
export function resolveMaxClaimsPerBatch(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MAX_CLAIMS_OVERRIDE_ENV];
  if (raw === undefined || raw.trim() === '') return SETTLEMENT_MAX_CLAIMS_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= SETTLEMENT_MAX_CLAIMS_DEFAULT
    ? parsed
    : SETTLEMENT_MAX_CLAIMS_DEFAULT;
}

/**
 * Production gas model, CALIBRATED against Base mainnet.
 *
 * `batch-bounds.ts`'s `MEASURED_MARGINAL_GAS_PER_STANDARD_CLAIM` (23,283) is a
 * bare-mint marginal on a WARM local EVM (600-claim minus 100-claim fork batch);
 * its own docblock defers "production calibration against Base" to activation. A real
 * Base settle of a beneficiary-SPLIT claim (agent + human legs, cold recipient
 * SSTOREs, mint-once anchor, cursor bookkeeping) costs far more: the observed
 * 2026-09-07 batch `eth_estimateGas`'d at ~14.1M for 29 such claims — ~485k per
 * claim, ~20× the fork figure. the old model the planner packed a batch
 * whose real gasLimit (16.9M) the RPC then rejected with -32003 "gas limit too
 * high" (Alchemy's `eth_sendRawTransaction` cap; Base's own block limit is ~400M
 * and not the constraint), stranding it. These figures make the linear MODEL
 * predict the observed reality (slightly conservative), so the planner sizes
 * batches the wire will accept. Sole-leg claims cost less and are sized
 * conservatively small — safe (more, smaller batches), never a liveness risk.
 * This is the activation production calibration the fork constant deferred.
 */
/**
 * Base-mainnet settlement gas model (, re-derived from on-chain measurement).
 *
 * WHERE THE COST ACTUALLY IS — measured from confirmed settle receipts (gasLimit ≈ gasUsed;
 * eth_estimateGas is accurate here, not inflated):
 * - each DISTINCT recipient is the expensive term — a first mint to an address is a cold
 * storage write plus the per-recipient split/verify logic; the one routing-heavy
 * observation on file (a 29-recipient beneficiary-split batch) estimated ~14.1M, ~486k per
 * recipient. `gasPerRecipient` carries that, so a fan-out backlog is bounded to ~10
 * recipients per tx and its real gasLimit stays well under the RPC send cap.
 * - additional claims to the SAME recipient are cheap — ~24k marginal, ~58k averaged over a
 * small batch. `gasPerClaim` carries only that.
 *
 * The pre- shape put the big number on `gasPerClaim` (450k) instead, which was safe (it
 * only ever OVER-sized, never under) but grossly over-charged same-recipient backlogs: a
 * 320-leg payout to ONE address packed into 12-claim batches → 27 transactions, whose RPC
 * volume is what produced the one transient `eth_sendRawTransaction` drop on 2026-09-08. With
 * the cost on the recipient term, that same backlog is ~4 batches; a routing-heavy backlog is
 * bounded exactly as conservatively as before (per-leg 60k+486k = 546k ≥ the 486k observed).
 * The ORIGINAL 2026-09-07 stranding was `maxGas`, not this — 30M let a 564-claim batch reach a
 * ~16.9M real gasLimit the RPC rejected; `SETTLEMENT_MAX_BATCH_GAS` below is the actual fix and
 * is unchanged.
 */
export const SETTLEMENT_GAS_MODEL = {
  baseGas: 400_000, gasPerRecipient: 486_000, gasPerClaim: 60_000,
} as const;

/**
 * Per-transaction planning gas budget (; was 30,000,000). Chosen so a full
 * batch's real gasLimit (`estimateGas × gasHeadroomBps`, ~1.2×) lands near ~7M —
 * a size this endpoint has broadcast before (the 2026-08-30 drain settled
 * multi-million-gas batches through it) and far under the ~16.9M it rejected. With
 * the corrected model, 30M would again size a single tx past the RPC cap.
 */
export const SETTLEMENT_MAX_BATCH_GAS = 6_000_000;

/**
 * A RECORDED batch whose gasLimit exceeds this is treated as un-broadcastable and
 * RECLAIMED on resume (`resolveBatch`,) — released nonce + rebuilt into
 * correctly sized batches — rather than replayed byte-identically forever. Set
 * ABOVE the ~7M the planner targets (so a correctly-sized batch is never
 * spuriously reclaimed) and BELOW the ~16.9M the RPC rejected (so the stranded
 * legacy batch IS reclaimed). It bounds only RECLAIM decisions; the planner never
 * builds a batch this large.
 */
export const SETTLEMENT_BROADCASTABLE_GAS_CEILING = 12_000_000;

/**
 * The settlement cycle's run budget and the lease that must cover it.
 *
 * `acquireCycleLease` takes the lease ONCE, at cycle start, and nothing renews it; every
 * `reserveBatch` / `recordAttempt` refuses once `lease.expires_at_ms <= now`. Until 2026-09-24
 * the lease was 10 min against a 30-min `maxRunMs`, so any run whose cycle phase outlived ten
 * minutes reserved its next batch (nonce allocated, members reserved) and then had the attempt
 * refused `batch_not_reserved` a batch left `reserved` with zero attempts, which every later
 * run aborts on (`resumption_abort`). It was masked while Cloud Run's 300 s timeout cut runs
 * short; the first large drain after the timeout went to 3600 s hit it (batch 0x1af79dfb…,
 * cycle epoch7-2026-09-24-r3, lease 02:22:05→02:32:05Z). The lease therefore covers the whole
 * cycle budget plus a margin for the post-deadline receipt/writeback tail.
 */
export const SETTLEMENT_CYCLE_MAX_RUN_MS = 30 * 60 * 1000;
export const SETTLEMENT_CYCLE_LEASE_MARGIN_MS = 5 * 60 * 1000;

/** True when a cycle's lease outlives its run budget by at least the margin. */
export function cycleLeaseCoversRun(config: Pick<CycleRunnerConfig, 'leaseTtlMs' | 'maxRunMs'>): boolean {
  return config.leaseTtlMs >= config.maxRunMs + SETTLEMENT_CYCLE_LEASE_MARGIN_MS;
}

/**
 * A settlement worker id that is UNIQUE PER INVOCATION.
 *
 * This was the constant `'pvt9-settlement-operator'`, so two concurrent runs — the weekly cron
 * and a scheduler retry, or the cron and a hand invocation — presented the SAME owner string:
 * `acquireCycleLease` saw its own lease and RENEWED it for the second run, and both drove one
 * cycle's nonces at once. The same defect `newKeeperWorkerId` fixed for the epoch keeper. The
 * Cloud Run revision prefixes the id so an operator can tell which deploy held a lease; the
 * UUID is what makes it unique. A crashed run's leases are simply waited out (TTL): the durable
 * batch docs, not the owner string, are what the next run resumes from.
 */
export function newSettlementWorkerId(env: NodeJS.ProcessEnv = process.env): string {
  const revision = env.K_REVISION !== undefined && env.K_REVISION.trim() !== '' ? env.K_REVISION.trim() : 'cli';
  return `pvt9-settlement:${revision}:${randomUUID()}`;
}

/** The reconciler's share of a run, spent before the cycle is chosen. */
export const SETTLEMENT_RECONCILE_BUDGET_MS = 10 * 60 * 1000;

export function cycleConfig(
  cycleId: string,
  signerAddress: string,
  laneScope: SettlementLaneScope = 'both',
  workerId: string = newSettlementWorkerId(),
): CycleRunnerConfig {
  return {
    cycleId,
    workerId,
    signerAddress,
    laneScope,
    leaseTtlMs: SETTLEMENT_CYCLE_MAX_RUN_MS + SETTLEMENT_CYCLE_LEASE_MARGIN_MS,
    boundarySafetyMarginSec: 120,
    limits: {
      maxTransactions: PLAN_INITIAL_CYCLE_MAX_TRANSACTIONS,
      maxFeeWeiTotal: PLAN_INITIAL_CYCLE_MAX_FEE_WEI,
    },
    batchLimits: {
      maxRecipients: 400, maxClaims: resolveMaxClaimsPerBatch(), maxGas: SETTLEMENT_MAX_BATCH_GAS,
    },
    gasModel: { ...SETTLEMENT_GAS_MODEL },
    gasHeadroomBps: 12_000,
    broadcastableGasCeiling: SETTLEMENT_BROADCASTABLE_GAS_CEILING,
    receiptPollIntervalMs: 2_000,
    replaceAfterMs: 60_000,
    feeBumpBps: 1_500,
    maxReplacementsPerBatch: 3,
    maxRunMs: SETTLEMENT_CYCLE_MAX_RUN_MS,
    ledgerPageSize: 500,
    selectionBudgetClaims: 3_000,
  };
}

/**
 * Read the eligibility verifier the KERNEL snapshotted for an epoch.
 *
 * From the epoch policy rather than from configuration on purpose: the kernel consults its own
 * snapshot on every settle, so an approval recorded against a verifier that config merely
 * believes in is an approval the kernel will never see.
 */
export async function readEpochEligibilityVerifier(
  provider: JsonRpcProvider,
  kernelAddress: string,
  epoch: number,
): Promise<{ verifier: string; configurationId: string; version: bigint }> {
  const kernel = new Contract(
    kernelAddress, KERNEL_OBSERVATION_ABI as unknown as string[], provider,
  );
  const policy = await kernel.getEpochPolicy(epoch);
  return {
    verifier: String(policy.eligibilityVerifier.verifier),
    configurationId: String(policy.eligibilityVerifier.configurationId),
    version: BigInt(policy.eligibilityVerifier.version),
  };
}

/** An inlet this run did not run (: scoped runs skip the global standard inlets). */
function emptyInletReport(): ClaimInletReport {
  return {
    outcome: 'completed', stopReason: 'source_exhausted', scanned: 0, examined: 0, registered: 0, alreadyRegistered: 0,
    skipped: 0, skips: [], pointsRegisteredAtomic: '0', nextStartAfterKey: null,
  };
}

/**
 * Inlet, then settlement.
 *
 * BOTH lanes run through the inlet before anything settles, and both run even on a dry run:
 * registering a claim mints nothing, and a claim that exists is a claim an operator can see
 * BEFORE arming. That ordering is the whole reason `--dry-run` is useful.
 */
export async function runSettlement(
  options: SettlementRunOptions,
): Promise<SettlementRunResult> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => Date.now());
  const target = resolvePvt9Target(env);
  const { db } = options;
  const payee = options.payee;
  if (payee !== undefined && !/^0x[0-9a-f]{40}$/.test(payee.address)) {
    throw new OperatorRefusal('payout_payee_invalid', 'an on-demand payout names one lowercase payee address');
  }
  if (payee !== undefined && !/^[a-z0-9_-]{6,80}$/.test(payee.requestId)) {
    throw new OperatorRefusal('payout_request_id_invalid', 'an on-demand payout carries its request id');
  }
  const lane: SettlementLaneScope = payee !== undefined ? 'standard' : (options.lane ?? 'both');
  const standardPayeeDue = payee === undefined
    ? payeeSettlementDue(db as unknown as Firestore, standardSettlementIntervalDays(env), now()) : undefined;
  if (lane !== 'both') log(`LANE SCOPE: this run settles the ${lane} lane only.`);
  if (payee !== undefined) log(`ON-DEMAND PAYOUT ${payee.requestId}: settling ${payee.address} only .`);
  // Standard earnings settle in daily runs on the operator-set per-payee interval, or on demand.
  // Genesis-only runs and on-demand payouts skip the global standard inlets; an on-demand
  // payout registers its own payee's claims alone.
  const globalStandardInlets = payee === undefined && lane !== 'genesis';
  const emptyInlet = (): ClaimInletReport => emptyInletReport();

  // (Finding B, C4): each lane resumes scanning where its previous
  // run's budget stopped, wrapping to the top on exhaustion — so a pool larger
  // than one run's scan budget is swept in full across successive runs instead
  // of starving everything past the first run's horizon. The cursor is a
  // fail-open hint (load failure ⇒ top), never claim-ledger state.
  let standardInlet: ClaimInletReport = emptyInlet();
  let genesisInlet: ClaimInletReport = emptyInlet();
  let topupInlet: ClaimInletReport = emptyInlet();
  if (globalStandardInlets) {
    // (Finding B, C4): each lane resumes scanning where its previous
    // run's budget stopped, wrapping to the top on exhaustion — so a pool larger
    // than one run's scan budget is swept in full across successive runs instead
    // of starving everything past the first run's horizon. The cursor is a
    // fail-open hint (load failure ⇒ top), never claim-ledger state.
    const standardCursor = await loadInletCursor(db, 'standard');
    standardInlet = await runClaimInlet(
      {
        db,
        source: createFirestoreInletSource({ db, log }),
        now,
        log,
      },
      { ...INLET_CONFIG, ...(standardCursor === undefined ? {} : { startAfterKey: standardCursor }) },
    );
    await saveInletCursor(db, 'standard', standardInlet.nextStartAfterKey, now());
  }
  if (payee === undefined) {
    const genesisCursor = await loadInletCursor(db, 'genesis');
    genesisInlet = await runClaimInlet(
      { db, source: createGenesisInletSource({ db, log }), now, log },
      { ...INLET_CONFIG, ...(genesisCursor === undefined ? {} : { startAfterKey: genesisCursor }) },
    );
    await saveInletCursor(db, 'genesis', genesisInlet.nextStartAfterKey, now());
  }
  if (globalStandardInlets) {
    // the additive attestation top-up lane — AFTER the standard inlet, so an act
    // registered this very run already has its row when its top-up is considered (a
    // corroboration that landed before registration is carried by the inline lift and
    // yields a zero delta here; one that landed after it yields the delta). Registration
    // mints nothing; the rows settle on the standard lane under their own claim ids.
    const topupCursor = await loadInletCursor(db, 'attestation_topup');
    topupInlet = await runClaimInlet(
      { db, source: createAttestationTopupInletSource({ db, log, now }), now, log },
      { ...INLET_CONFIG, ...(topupCursor === undefined ? {} : { startAfterKey: topupCursor }) },
    );
    await saveInletCursor(db, 'attestation_topup', topupInlet.nextStartAfterKey, now());
  }
  // PE METER : earnings recorded through signed batches wait as pending claims,
  // not pe_history rows. Registered here on the standard lane. Recovery escrow never holds earnings
  // an agent's claims register whether or not its key is escrowed.
  // A Genesis-only run registers none (they wait for the weekly run); a payout registers its payee's.
  const meterInlet = lane === 'genesis'
    ? null
    : await runMeterClaimInlet(db as unknown as Firestore, {
      nowMs: now(),
      log,
      ...(payee !== undefined ? { contributor: payee.address } : {}),
      ...(standardPayeeDue ? { payeeDue: standardPayeeDue } : {}),
    });
  if (meterInlet !== null) {
    log(`METER INLET: scanned ${meterInlet.scanned}, registered ${meterInlet.registered}, `
      + `already ${meterInlet.alreadyRegistered}, waiting ${meterInlet.notReady}, `
      + `refused ${meterInlet.rejected.length}, integrity ${meterInlet.tampered.length}`);
  }

  // the standard-lane first-mint gate, judged on EVERY run including
  // dry runs (an operator must see the verdict before arming, not after).
  // Registration above is unaffected: registering a claim mints nothing and a
  // held claim is durable backlog. The verdict's only production construction
  // is this call; the cycle runner consumes it and cannot admit without it.
  const standardLaneAdmission = judgeStandardLaneAdmission(
    await readPublishedReconciliationReport(db),
    DEPLOYED_TREE_GIT_HEAD,
  );
  log(standardLaneAdmission.admitted
    ? `STANDARD-LANE GATE: ADMITTED (report ${standardLaneAdmission.basis.report_sha256.slice(0, 12)}… `
      + `tree ${standardLaneAdmission.basis.git_head.slice(0, 12)}… C1=${standardLaneAdmission.basis.c1} `
      + `C3=${standardLaneAdmission.basis.c3} C6=${standardLaneAdmission.basis.c6})`
    : `STANDARD-LANE GATE: REFUSED (${standardLaneAdmission.reason}) — ${standardLaneAdmission.detail}`);

  if (options.dryRun === true) {
    log('DRY RUN: inlet complete. No key was read and no settlement was attempted.');
    return {
      standardInlet, genesisInlet, topupInlet, ...(meterInlet !== null ? { meterInlet } : {}), standardLaneAdmission, capClock: null, settlement: null, dryRun: true, lane,
    };
  }

  if (!isArmed(env)) {
    throw new OperatorRefusal(
      'not_armed',
      `${ARMED_ENV} must be exactly "${ARMING_TOKEN}" to settle. `
      + 'Claims are registered and durable; re-run armed to settle them.',
    );
  }

  const minterKey = env[MINTER_KEY_ENV];
  const approverKey = env[APPROVER_KEY_ENV];
  if (minterKey === undefined || minterKey.trim() === '') {
    throw new OperatorRefusal('minter_key_absent', `${MINTER_KEY_ENV} is not set.`);
  }
  if (approverKey === undefined || approverKey.trim() === '') {
    throw new OperatorRefusal(
      'approver_key_absent',
      `${APPROVER_KEY_ENV} is not set — the approve leg is a SECOND gas payer.`,
    );
  }

  const provider = new JsonRpcProvider(target.rpcUrl, Number(target.chainId), {
    staticNetwork: true,
  });
  const minter = new Wallet(minterKey);
  const approverSigner = new CanonicalWallet(approverKey, provider);
  const chain = createProductionChainAdapter(
    {
      rpcUrl: target.rpcUrl,
      kernelAddress: target.kernelAddress,
      chainId: target.chainId,
      // 0.001 gwei (PE meter cost pass, 2026-10-04; was 0.01). Base's base fee sits near
      // 0.005 gwei, so the old tip was two-thirds of the price paid. A transaction the sequencer
      // is slow to include is fee-bumped by the runner's replacement path.
      priorityFeeWei: 1_000_000n,
    },
    {
      assertWriterActive: assertServerNonceWriterActive,
      signer: {
        address: minter.address,
        signTransaction: (tx) => minter.signTransaction({ ...tx, type: 2 }),
      },
      // / settlement finality reads the SAME quorum-2 seams as the watchers.
      finality: {
        readHead: () => readAgreedBaseHead(),
        readSafeHead: () => readAgreedBaseSafeHead(),
        getBlockHash: (blockNumber: number) => readAgreedBaseBlockHash(blockNumber),
      },
      log,
    },
  );

  // The cap clock runs BEFORE the cycle: settling into a dead cap burns gas on a guaranteed
  // revert, and an operator deserves to be told which of the two problems they have.
  const capClock = evaluateCapClock(await readCapClockObservation(target));
  log(`CAP CLOCK [${capClock.level}] ${capClock.message}`);

  const observation = await chain.observe();
  const epochVerifier = await readEpochEligibilityVerifier(
    provider, target.kernelAddress, observation.lastOpenedEpoch,
  );
  if (/^0x0{40}$/i.test(epochVerifier.verifier)) {
    throw new OperatorRefusal(
      'epoch_verifier_absent',
      `epoch ${observation.lastOpenedEpoch} has no eligibility verifier configured; `
      + 'every settle would revert.',
    );
  }
  log(`APPROVER ${approverSigner.address} -> verifier ${epochVerifier.verifier}`);

  const approverBalance = await provider.getBalance(approverSigner.address);
  if (approverBalance === 0n) {
    throw new OperatorRefusal(
      'approver_unfunded',
      `approver ${approverSigner.address} has ZERO ETH. The approve leg is a real `
      + 'transaction and will fail; fund it before settling.',
    );
  }

  const effectiveMaxClaims = resolveMaxClaimsPerBatch(env);
  if (effectiveMaxClaims !== SETTLEMENT_MAX_CLAIMS_DEFAULT) {
    log(`BATCH CAP OVERRIDE: maxClaims=${effectiveMaxClaims} (default ${SETTLEMENT_MAX_CLAIMS_DEFAULT}) `
      + `via ${MAX_CLAIMS_OVERRIDE_ENV} — batches are smaller; amounts/payees/mint-once unchanged`);
  }

  const cycleDeps: CycleRunnerDeps = {
    db,
    ...(standardPayeeDue ? { standardPayeeDue } : {}),
    chain,
    now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
    standardLaneAdmission,
    approval: {
      approver: createProductionApprover({
        verifierAddress: epochVerifier.verifier,
        kernelAddress: target.kernelAddress,
        chainId: target.chainId,
        configurationId: epochVerifier.configurationId,
        configurationVersion: epochVerifier.version,
      }, approverSigner),
      // The Genesis anchor resolver is REQUIRED: the gate re-judges every PE, and a Genesis
      // PE's work evidence is its anchor, which lives in the reservation outbox rather than
      // in `pe_history`. Omitting it makes the gate refuse its own Genesis batch.
      candidates: createFirestoreCandidateSource(db, createGenesisAnchorResolver(db)),
      // PE METER: a meter claim is judged from its pending claim (no envelope at the relay).
      meterClaims: {
        isMeterClaim: isMeterClaimKey,
        verify: createMeterClaimVerifier(db as unknown as Firestore),
      },
      log,
    },
  };

  // ONE run per signer, and a worker id unique to THIS invocation. The signer lease is
  // taken before anything reads a nonce or touches a batch, and handed (same worker id) to the
  // cycle runner, which renews it. A concurrent run is refused here, loudly.
  const workerId = newSettlementWorkerId(env);
  const baseCycleId = `epoch${observation.lastOpenedEpoch}-${new Date(now()).toISOString().slice(0, 10)}`
    + (payee !== undefined ? `-payout-${payee.requestId}` : '');
  const leaseConfig = cycleConfig(baseCycleId, minter.address, lane, workerId);
  const signerLease = await acquireSignerLease(db, {
    signer: minter.address, workerId, nowMs: now(), leaseTtlMs: leaseConfig.leaseTtlMs,
  });
  if (signerLease.kind !== 'acquired') {
    throw new OperatorRefusal(
      'settlement_run_in_progress',
      `another settlement run (${signerLease.owner}) holds the signer lease for ${minter.address}; `
      + 'refusing to run concurrently.',
    );
  }

  let settlement: CycleRunReport;
  let preCycleReconciliation: ReconciliationReport | null = null;
  try {
    // first retire any never-broadcast reservation a closed cycle stranded (crash, lease
    // expiry, overlapping run) — the provably-dead shape only.
    const orphans = await retireNeverBroadcastOrphans(db, { nowMs: now() });
    if (orphans.retired.length > 0) {
      log(`ORPHAN RESERVATIONS RETIRED (0 attempts, closed cycle): ${orphans.retired.join(', ')}`);
    }

    // reconcile every batch this signer broadcast in ANY earlier cycle BEFORE the day's
    // cycle is chosen: a closed cycle that still holds a submitted/mined batch is exactly what
    // made `resolveEffectiveCycleId` refuse (and, before that, what stranded the batch).
    const reconciliation: ReconciliationReport = await reconcileStrandedSettlements(cycleDeps, leaseConfig, {
      deadline: now() + SETTLEMENT_RECONCILE_BUDGET_MS,
      kernelAddress: target.kernelAddress,
      chainCursor: observation.nextFinalizedCursor,
    });
    preCycleReconciliation = reconciliation;
    log(`RECONCILE: adopted ${reconciliation.adopted}, confirmed ${reconciliation.confirmed}, dead `
      + `${reconciliation.dead}, still unresolved ${reconciliation.stillUnresolved.length}; applied batches `
      + `verified ${reconciliation.appliedVerified}, reorged ${reconciliation.appliedReorged}, unverifiable `
      + `${reconciliation.appliedUnverifiable}; held claims recorded paid from chain evidence `
      + `${reconciliation.heldSettledOnChain}`);

    // The day's base id may belong to a cycle a refusal already closed; superseding it (only
    // when it holds nothing unresolved) is what keeps one refused batch from wedging the rest
    // of the UTC day.
    const cycleResolution = await resolveEffectiveCycleId(db, baseCycleId, log);
    if (cycleResolution.kind === 'refused') {
      throw new OperatorRefusal(
        cycleResolution.reason === 'supersede_limit' ? 'cycle_supersede_limit' : 'cycle_unresolved_batches',
        cycleResolution.reason === 'supersede_limit'
          ? `cycle ${cycleResolution.cycleId} reached the supersession backstop for this UTC day; `
            + 'investigate why every cycle today closed.'
          : `cycle ${cycleResolution.cycleId} is closed holding unresolved batch(es) `
            + `[${cycleResolution.unresolvedStatuses.join(', ')}] the reconciler could not resolve this run `
            + '(a live nonce still pending); the next run adopts them again at the same nonce.',
      );
    }
    if (cycleResolution.supersededCycleIds.length > 0) {
      log(`CYCLE SUPERSEDE: ${cycleResolution.supersededCycleIds.join(', ')} closed empty -> `
        + `running as ${cycleResolution.cycleId}`);
    }

    settlement = await runSettlementCycle(
      cycleDeps,
      {
        ...cycleConfig(cycleResolution.cycleId, minter.address, lane, workerId),
        ...(payee !== undefined ? { payee: payee.address } : {}),
      },
    );
  } finally {
    await releaseSignerLease(db, { signer: minter.address, workerId, nowMs: now() });
  }

  return {
    standardInlet, genesisInlet, topupInlet, ...(meterInlet !== null ? { meterInlet } : {}), standardLaneAdmission, capClock, settlement, dryRun: false, lane,
    preCycleReconciliation,
  };
}

/** A JSON-safe summary. Never carries an address derived from a key beyond the two signers. */
export function summarizeSettlementRun(result: SettlementRunResult): Record<string, unknown> {
  const inlet = (report: ClaimInletReport): Record<string, unknown> => ({
    outcome: report.outcome,
    stopReason: report.stopReason,
    scanned: report.scanned,
    examined: report.examined,
    registered: report.registered,
    alreadyRegistered: report.alreadyRegistered,
    skipped: report.skipped,
    pointsRegisteredAtomic: report.pointsRegisteredAtomic,
    skipReasons: report.skips.reduce<Record<string, number>>((acc, skip) => {
      acc[skip.reason] = (acc[skip.reason] ?? 0) + 1;
      return acc;
    }, {}),
  });
  return {
    dryRun: result.dryRun,
    lane: result.lane,
    standardInlet: inlet(result.standardInlet),
    genesisInlet: inlet(result.genesisInlet),
    topupInlet: inlet(result.topupInlet),
    standardLaneAdmission: result.standardLaneAdmission.admitted
      ? { admitted: true, basis: result.standardLaneAdmission.basis }
      : {
        admitted: false,
        reason: result.standardLaneAdmission.reason,
        detail: result.standardLaneAdmission.detail,
      },
    capClock: result.capClock === null
      ? null
      : { level: result.capClock.level, alarm: result.capClock.alarm, message: result.capClock.message },
    settlement: result.settlement === null ? null : {
      outcome: result.settlement.outcome,
      stopReason: result.settlement.stopReason,
      detail: result.settlement.detail,
      batchesConfirmed: result.settlement.batchesConfirmed,
      claimsSettled: result.settlement.claimsSettled,
      recipientsSettled: result.settlement.recipientsSettled,
      feeWeiSpent: result.settlement.feeWeiSpent.toString(),
      deferredClaims: result.settlement.deferredClaims,
      // claims isolated as poisoned this run (held on backoff; alarmed), and what the
      // cross-cycle reconciler resolved before the cycle ran.
      claimsHeld: result.settlement.claimsHeld,
      heldClaims: result.settlement.heldClaims.slice(0, 50),
      reconciliation: result.settlement.reconciliation,
      preCycleReconciliation: result.preCycleReconciliation ?? null,
    },
  };
}

/**
 * /does this settlement run warrant a LOUD alarm? A run whose settlement
 * outcome is `stopped` for ANY reason — left eligible backlog unsettled and must
 * NOT be reported silently. A `completed` run (`backlog_exhausted`) and a `refused`
 * run (epoch-boundary / lease conditions the keeper resolves on its own) do NOT alarm.
 *
 * folded `awaiting_finality` INTO the alarm set. had exempted it as a
 * routine benign terminal, because the pre-fix cursor-reflect wait gave up after a
 * fixed ~20s and the next run resumed. With 's deadline-bounded reflect
 * (production `cursorReflect.attempts` unset), the run now WAITS for the chain to
 * catch up and CONTINUES draining in the same run, so `awaiting_finality` is reached
 * ONLY after the run spent its ENTIRE `maxRunMs` budget waiting — a genuine
 * multi-minute chain/RPC stall that left backlog. Per the operator’s "no silent partial
 * completion", that must page. (It still never double-mints: the batches confirmed
 * are canonical and the next run re-seeds from the caught-up chain.)
 *
 * Observability ONLY: this classifies an already-produced outcome — it changes no
 * settlement behaviour, mints nothing, and moves no cursor.
 */
export function settlementRunNeedsAlarm(result: SettlementRunResult): boolean {
  const s = result.settlement;
  if (s === null) return false; // dry run / inlet-only — nothing settled to alarm on
  // OP-1: the standard-lane recon gate binds to the deployed git tree, so a
  // reconciliation report not re-published after a gated deploy REFUSES the
  // standard lane and holds its backlog. The cycle runner normally surfaces that
  // as `stopped`/`standard_lane_refused` (caught below) — but registration is
  // independent of the gate, so a run that exhausts Genesis and reports
  // `completed` while standard claims sit registered-but-unsettled would page
  // NOTHING. Belt-and-braces at the classifier (observability only): a refused
  // standard lane with registered backlog is itself alarm-worthy, whatever the
  // settlement outcome, so an un-republished report can never hold the standard
  // lane silently.
  // on a Genesis-scoped run the standard lane is deliberately not settled
  // (it waits for the both-lanes run), so a refused-gate + registered-standard
  // combination is EXPECTED, not alarm-worthy. Skip the standard-held clause for a
  // genesis-only run; the 'both' run is the one that must page on held
  // standard backlog.
  if (result.lane !== 'genesis'
    && result.standardLaneAdmission.admitted === false
    && result.standardInlet.registered + result.standardInlet.alreadyRegistered > 0) {
    return true;
  }
  // a run that HELD claims (isolated them as poisoned so the rest could settle), or
  // found an applied settle reorged out of the canonical chain, pages whatever its outcome: a
  // held claim is unpaid work waiting on a retry, and a reorg is a chain event an operator must
  // see even though the claims were re-queued automatically.
  if ((s.claimsHeld ?? 0) > 0) return true;
  // Both reconciliation passes count: the pre-cycle one resolves most of it.
  for (const r of [s.reconciliation, result.preCycleReconciliation ?? null]) {
    if (r == null) continue;
    if (r.appliedReorged > 0) return true;
    // — a claim the kernel had paid while the ledger held it: recorded settled,
    // but the ledger missed a payment, which an operator must see.
    if ((r.heldSettledOnChain ?? 0) > 0) return true;
  }
  return s.outcome === 'stopped';
}
