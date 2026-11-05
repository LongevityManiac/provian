/**
 * PVT - Anchor Recovery CLI
 *
 * Manual entrypoint for ops. Designed to be invoked via:
 *   npm run anchor-recovery
 *
 * This legacy entrypoint is read-only. Execute mode is retired and fails
 * closed; anchor broadcasts are owned exclusively by mint-claim recovery.
 */

import { ethers } from 'ethers';
import {
  runAnchorRecoveryWorker,
  type AnchorRecoveryWorkerOptions,
} from './anchor-recovery-worker';
import { PVT_ABI, PE_ANCHOR_ABI } from '../agent-bank/types';

// =============================================================================
// ARG PARSING
// =============================================================================

export interface ParsedCliArgs {
  execute: boolean;
  fromBlock?: number;
  toBlock?: number;
  confirmations?: number;
  defaultLookback?: number;
  blockChunk?: number;
  // Cost guardrails - flag overrides; otherwise sourced from env in
  // buildGuardrailOptionsFromEnv().
  maxAnchorsPerRun?: number;
  maxAttemptsPerBatch?: number;
  minRetryIntervalMs?: number;
  maxGasUsdPerRun?: number;
  gasPriceCeilingGwei?: number;
}

export function parseCliArgs(
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): ParsedCliArgs {
  const flags = new Map<string, string>();
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    if (eq === -1) {
      flags.set(raw.slice(2), 'true');
    } else {
      flags.set(raw.slice(2, eq), raw.slice(eq + 1));
    }
  }

  // Execute mode requires BOTH a CLI flag path AND/OR env var path. Either
  // path is sufficient on its own, but the default is dry-run.
  const cliExecute = flags.get('execute');
  const envExecute = env.ANCHOR_RECOVERY_EXECUTE;
  const execute = cliExecute === 'true' || envExecute === 'true';

  return {
    execute,
    fromBlock: maybeNumber(flags.get('fromBlock')),
    toBlock: maybeNumber(flags.get('toBlock')),
    confirmations: maybeNumber(flags.get('confirmations')),
    defaultLookback: maybeNumber(flags.get('defaultLookback')),
    blockChunk: maybeNumber(flags.get('blockChunk')),
    maxAnchorsPerRun: maybeNumber(flags.get('maxAnchorsPerRun')),
    maxAttemptsPerBatch: maybeNumber(flags.get('maxAttemptsPerBatch')),
    minRetryIntervalMs: maybeNumber(flags.get('minRetryIntervalMs')),
    maxGasUsdPerRun: maybeNumber(flags.get('maxGasUsdPerRun')),
    gasPriceCeilingGwei: maybeNumber(flags.get('gasPriceCeilingGwei')),
  };
}

/**
 * Pull guardrail + tuning defaults from environment variables. CLI flags
 * override these; absent flags + absent env vars fall back to worker
 * defaults.
 *
 * Env contract (Cloud Run job sets these):
 *   ANCHOR_RECOVERY_MAX_ANCHORS_PER_RUN
 *   ANCHOR_RECOVERY_MAX_ATTEMPTS_PER_BATCH
 *   ANCHOR_RECOVERY_MIN_RETRY_INTERVAL_MS
 *   ANCHOR_RECOVERY_MAX_GAS_USD              (default 50)
 *   ANCHOR_RECOVERY_GAS_PRICE_CEILING_GWEI   (default 100)
 *   ANCHOR_RECOVERY_BLOCK_CHUNK              (default 5000; raise for private RPCs)
 */
export function buildGuardrailOptionsFromEnv(env: NodeJS.ProcessEnv): {
  maxAnchorsPerRun?: number;
  maxAttemptsPerBatch?: number;
  minRetryIntervalMs?: number;
  maxGasUsdPerRun?: number;
  gasPriceCeilingGwei?: number;
  blockChunk?: number;
} {
  return {
    maxAnchorsPerRun: maybeNumber(env.ANCHOR_RECOVERY_MAX_ANCHORS_PER_RUN),
    maxAttemptsPerBatch: maybeNumber(env.ANCHOR_RECOVERY_MAX_ATTEMPTS_PER_BATCH),
    minRetryIntervalMs: maybeNumber(env.ANCHOR_RECOVERY_MIN_RETRY_INTERVAL_MS),
    maxGasUsdPerRun: maybeNumber(env.ANCHOR_RECOVERY_MAX_GAS_USD),
    gasPriceCeilingGwei: maybeNumber(env.ANCHOR_RECOVERY_GAS_PRICE_CEILING_GWEI),
    blockChunk: maybeNumber(env.ANCHOR_RECOVERY_BLOCK_CHUNK),
  };
}

function maybeNumber(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

// =============================================================================
// MAIN
// =============================================================================

/**
 * CLI entrypoint. Returns the worker report so callers / tests can assert on
 * it. Side effects (Firestore + RPC) flow through the deps the caller wires up.
 */
export async function runAnchorRecoveryCli(deps: {
  argv: ReadonlyArray<string>;
  env: NodeJS.ProcessEnv;
  buildWorkerDeps: () => Promise<Parameters<typeof runAnchorRecoveryWorker>[0]>;
  log?: (msg: string) => void;
}): Promise<Awaited<ReturnType<typeof runAnchorRecoveryWorker>>> {
  const log = deps.log ?? ((m) => console.log(m));
  const args = parseCliArgs(deps.argv, deps.env);

  if (args.execute) {
    throw new Error('anchor_recovery_execute_retired_use_mint_claim_recovery');
  }

  const guardrailEnv = buildGuardrailOptionsFromEnv(deps.env);
  const opts: AnchorRecoveryWorkerOptions = {
    execute: args.execute,
    fromBlock: args.fromBlock,
    toBlock: args.toBlock,
    confirmations: args.confirmations,
    defaultLookback: args.defaultLookback,
    // CLI flag wins; otherwise env; otherwise worker default.
    blockChunk: args.blockChunk ?? guardrailEnv.blockChunk,
    maxAnchorsPerRun: args.maxAnchorsPerRun ?? guardrailEnv.maxAnchorsPerRun,
    maxAttemptsPerBatch: args.maxAttemptsPerBatch ?? guardrailEnv.maxAttemptsPerBatch,
    minRetryIntervalMs: args.minRetryIntervalMs ?? guardrailEnv.minRetryIntervalMs,
    maxGasUsdPerRun: args.maxGasUsdPerRun ?? guardrailEnv.maxGasUsdPerRun,
    gasPriceCeilingGwei: args.gasPriceCeilingGwei ?? guardrailEnv.gasPriceCeilingGwei,
  };

  log('[anchor-recovery-cli] READ-ONLY: execution is retired; mint-claim recovery owns anchor broadcasts.');

  const workerDeps = await deps.buildWorkerDeps();
  const report = await runAnchorRecoveryWorker(workerDeps, opts);
  log(`[anchor-recovery-cli] scanned blocks ${report.scanned_from}-${report.scanned_to}, events=${report.events_seen}, dry_run=${report.dry_run}`);
  log(`[anchor-recovery-cli] outcomes=${JSON.stringify(report.outcomes)}`);
  return report;
}

// =============================================================================
// DEFAULT WIRING (used when invoked via `npm run anchor-recovery`)
// =============================================================================

/**
 * Build live deps from env. Only invoked when this file is the entrypoint;
 * tests bypass this entirely by passing their own buildWorkerDeps.
 */
export async function buildLiveWorkerDeps(): Promise<Parameters<typeof runAnchorRecoveryWorker>[0]> {
  // Lazy-require firebase-admin so unit tests for parseCliArgs don't need it.
  const admin = await import('firebase-admin');
  const { FieldValue } = await import('firebase-admin/firestore');
  if (admin.apps.length === 0) {
    admin.initializeApp();
  }
  const { relayDb } = await import('../../firestore-db');
  const db = relayDb();

  const rpcUrl = process.env.BASE_RPC_URL;
  const pvtAddress = process.env.PVT_CONTRACT_ADDRESS;
  const peAnchorAddress = process.env.PE_ANCHOR_CONTRACT_ADDRESS;

  if (!rpcUrl) throw new Error('BASE_RPC_URL not set');
  if (!pvtAddress) throw new Error('PVT_CONTRACT_ADDRESS not set');
  if (!peAnchorAddress) throw new Error('PE_ANCHOR_CONTRACT_ADDRESS not set');

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  // Deliberately read-only: the retired CLI never constructs a signer even if
  // PVT_MINTER_KEY happens to be present in the environment.
  const pvtContract = new ethers.Contract(pvtAddress, PVT_ABI, provider);
  const peAnchorContract = new ethers.Contract(peAnchorAddress, PE_ANCHOR_ABI, provider);

  // Gas oracle: live network gas price + ETH/USD from env. We deliberately
  // don't pull an external price feed here - the worker only uses this for
  // cost guardrails, and a stale-but-conservative ETH/USD value is safer
  // than a network call that could hang the run. Operator updates
  // ANCHOR_RECOVERY_ETH_USD_PRICE periodically via Cloud Run config.
  const ethPriceUsd = Number(process.env.ANCHOR_RECOVERY_ETH_USD_PRICE ?? '2500');
  const gasOracle = async (): Promise<{ gasPriceWei: bigint; ethPriceUsd: number }> => {
    const fee = await provider.getFeeData();
    // Prefer maxFeePerGas (EIP-1559) when available, fall back to gasPrice.
    const gasPriceWei = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
    return { gasPriceWei, ethPriceUsd };
  };

  return {
    db,
    pvtContract,
    peAnchorContract,
    fieldValue: FieldValue,
    gasOracle,
  };
}

// Direct invocation: `node dist/core/pvt/anchor-recovery-cli.js`.
// Wrapped in a function so importing this module (e.g. from tests) does not
// trigger argv parsing.
if (require.main === module) {
  runAnchorRecoveryCli({
    argv: process.argv.slice(2),
    env: process.env,
    buildWorkerDeps: buildLiveWorkerDeps,
  })
    .then((report) => {
      // Surface refusals in the exit code so ops scripts can branch.
      const refused =
        (report.outcomes['refused_snapshot_missing'] ?? 0) +
        (report.outcomes['refused_merkle_root_mismatch'] ?? 0) +
        (report.outcomes['refused_batch_id_mismatch'] ?? 0);
      process.exit(refused > 0 ? 2 : 0);
    })
    .catch((err) => {
      console.error('[anchor-recovery-cli] fatal:', err);
      process.exit(1);
    });
}
