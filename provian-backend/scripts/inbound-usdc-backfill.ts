/**
 * recover and witness the inbound USDC one agent wallet missed while it
 * was excluded from the inbound watcher (e.g. Atlas after its key rotations).
 *
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/inbound-usdc-backfill.ts <wallet_id> # dry run (default)
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/inbound-usdc-backfill.ts <wallet_id> --execute # witness
 * [--from-block N] [--to-block N] clip every lineage window (never widens one)
 * [--block-chunk N] blocks per getLogs call (default 2000 — mainnet.base.org's
 * eth_getLogs cap; a provider that refuses a range as too
 * large (HTTP 413 etc.) has it split and retried, never skipped)
 * [--json <path>] also write the full report to a file
 *
 * What it does (see src/core/pvt/inbound-usdc-backfill.ts): proves the wallet's
 * address lineage from sealed history, computes each address's creditable block
 * window (its own H+1 fence through the next rotation's observed head; the
 * current address through the live watcher's committed checkpoint), and runs
 * every transfer found in those windows through the watcher's own claim path —
 * two-operator verification, mint-once claim `8453_<tx>_<logIndex>`,
 * deterministic PE id. Idempotent: a rerun reports `already_witnessed`. A claim
 * stranded behind the rotation (its admission deleted) is driven to completion
 * (`recovered`). Pre-fence and post-retirement transfers are refused.
 *
 * Environment — the SAME values the relay runs with (Cloud Run env):
 * - Base RPC operator pair: BASE_RPC_URL / BASE_RPC_OPERATOR_ID and
 * BASE_RPC_SECONDARY_URL / BASE_RPC_SECONDARY_OPERATOR_ID (the agreed two-leg reader).
 * - FRANK_PVT_APPROVAL_SSH_PUBLIC_KEY and FRANK_PVT_APPROVAL_SSH_KEY_SHA256: the approval
 * verifier the accrual uses to validate the signed monetary activation. WITHOUT THEM THE
 * ACCRUAL PRICES UNDER THE INACTIVE RECORD-ONLY POLICY and every recovered receive would seal
 * 0 PVT, permanently (deterministic PE id). --execute REFUSES before any write unless the
 * monetary preflight admits: approval env present, NODE_ENV not `test`, the live activation
 * `quiet_active`, this tree's template digest EQUAL to the live document's, activity mapping
 * not paused, and the active `receive` policy at each transfer's block timestamp.
 * - for --execute, UPSTASH_REDIS_REST_URL / _TOKEN: the accrual's rate-limit and mint-once
 * counters live there, so --execute REFUSES to run without them.
 * The dry run prints the preflight verdict and each transfer's projected mint disposition and
 * record points (from the record path's own estimator) — read them before --execute.
 * Run AFTER the relay is deployed, so the live watcher owns the current address from its
 * checkpoint forward. Never run two instances for one wallet at once.
 */
import * as fs from 'fs';
import admin from 'firebase-admin';

import { cache } from '../src/cache';
import { recordPEAccrual } from '../src/pvt-accrual';
import { initPEBatchWriter, drainPEBatchWriter } from '../src/pe-batch-writer';
import type { AgentBankDeps } from '../src/core/agent-bank/types';
import { buildBaseInboundDeps } from '../src/core/pvt/inbound-usdc-watcher';
import { runInboundUsdcBackfill } from '../src/core/pvt/inbound-usdc-backfill';
import { scriptDb } from './lib/script-db';

/** The public Base RPC's eth_getLogs range cap; larger ranges answer HTTP 413. */
const DEFAULT_BLOCK_CHUNK = 2_000;

function intArg(args: string[], flag: string): number | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = Number(args[index + 1]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${flag} must be a non-negative integer`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const walletId = args[0];
  if (!walletId || walletId.startsWith('--')) {
    console.error('usage: inbound-usdc-backfill.ts <wallet_id> [--execute] [--from-block N] [--to-block N] [--block-chunk N] [--json path]');
    process.exit(2);
  }
  const execute = args.includes('--execute');
  const fromBlock = intArg(args, '--from-block');
  const toBlock = intArg(args, '--to-block');
  const blockChunk = intArg(args, '--block-chunk') ?? DEFAULT_BLOCK_CHUNK;
  const jsonIndex = args.indexOf('--json');
  const jsonPath = jsonIndex >= 0 ? args[jsonIndex + 1] : undefined;

  if (admin.apps.length === 0) admin.initializeApp();
  // round 2: the relay's OWN client settings (scriptDb applies them), before any Firestore use.
  // Without them the shared pe_history write refuses `undefined` and a receive
  // PE is sealed with no pe_history row (the first prod --execute failed so).
  const db = scriptDb();
  cache.initialize();
  if (execute && !cache.isEnabled()) {
    console.error('--execute refused: the relay Upstash cache is not configured (UPSTASH_REDIS_REST_URL/_TOKEN).');
    process.exit(2);
  }
  const bankDeps = {
    db,
    cache,
    peBuffer: initPEBatchWriter(db),
    recordPEAccrual,
  } as unknown as AgentBankDeps;

  const report = await runInboundUsdcBackfill({
    deps: buildBaseInboundDeps(bankDeps),
    walletId,
    execute,
    fromBlock,
    toBlock,
    blockChunk,
    segmentBlocks: Math.max(blockChunk, 10_000),
    onProgress: (line) => console.log(line),
  });
  await drainPEBatchWriter();

  console.log(`\n=== inbound USDC backfill — ${execute ? 'EXECUTED' : 'DRY RUN'} ===`);
  console.log(`wallet ${report.wallet_id} (agent ${report.agent_id}), rotations ${report.rotation_count}, live checkpoint ${report.global_checkpoint}`);
  console.log(`firestore write parity: ${report.firestore_write_parity_refusal === null
    ? 'matches the relay' : `REFUSES --execute (${report.firestore_write_parity_refusal})`}`);
  const pf = report.monetary_preflight;
  console.log(`monetary preflight: ${pf.admits_execute ? 'ADMITS --execute' : `REFUSES --execute (${pf.refusal})`}`
    + ` | verdict ${pf.activation_verdict} | approval env ${pf.approval_env_present ? 'present' : 'ABSENT'}`
    + ` | digest computed ${pf.computed_template_sha256} pinned ${pf.pinned_template_sha256 ?? 'none'}`
    + ` | policy ${pf.policy_version ?? 'none'} | activity mapping ${pf.activity_mapping_enabled ? 'on' : 'PAUSED'}`);
  for (const window of report.windows) {
    console.log(`  window ${window.lineageIndex} ${window.address} ${window.status}: `
      + `${window.startBlock ?? '-'}..${window.endBlock ?? '-'} fence=${window.fenceSource ?? '-'}`
      + `${window.refused ? ` REFUSED(${window.refused})` : ''}`);
  }
  console.log('\n tx_hash | log_index | block | from | to | amount_atomic | pe_id | outcome | mint_status'
    + ' | projected_disposition | projected_record_points_atomic | policy | error');
  for (const t of report.transfers) {
    const p = t.projection;
    console.log(` ${t.tx_hash} | ${t.log_index} | ${t.block_number} | ${t.from} | ${t.to} | ${t.amount_atomic}`
      + ` | ${t.pe_id ?? '-'} | ${t.outcome} | ${t.mint_status ?? '-'}`
      + ` | ${p ? `${p.mint_disposition}(${p.mint_reason_code})` : '-'} | ${p ? p.record_points_atomic : '-'}`
      + ` | ${p ? `${p.policy_version}${p.policy_active ? '' : ' INACTIVE'}` : '-'} | ${t.error ?? ''}`);
  }
  console.log(`\ntotals ${JSON.stringify(report.totals)}`);
  if (jsonPath) fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  const failed = report.transfers.some((t) =>
    t.outcome === 'recovery_failed' || t.outcome === 'emit_failed' || t.outcome === 'claim_create_failed'
    || t.outcome === 'refused_unverified' || t.outcome === 'refused_monetary_policy_inactive');
  if (failed) process.exitCode = 3;
}

main().catch((error) => { console.error(error); process.exit(1); });
