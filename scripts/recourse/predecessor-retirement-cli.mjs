#!/usr/bin/env -S tsx
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Wallet } from 'ethers';
import { scriptDb } from '../../provian-backend/scripts/lib/script-db.ts';
import { snapshotRpcPort } from './snapshot-cli.mjs';
import { readSuccessorArtifacts } from './successor-preflight.mjs';
import { preparePredecessorRetirement, verifyPredecessorRetirement, predecessorRetirementValidator } from './predecessor-retirement.mjs';
import { runChangeoverStage } from './changeover-runtime.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ensure = (value, reason) => { if (!value) throw Error('retirement_cli_' + reason); };
const read = path => JSON.parse(readFileSync(resolve(path), 'utf8'));
const exec = promisify(execFile);

/** Validation precedes every journal/key access. Even already-held flags do
 * not skip a nonempty stage's original receipt reconciliation. A plan prepared
 * after retirement has no steps and is independently verified read-only. */
export async function advancePredecessorRetirement({ plan, deployment, artifacts, port, execute, runtime }) {
  const verified = await verifyPredecessorRetirement({ plan, deployment, artifacts, port });
  if (plan.steps.length === 0) {
    ensure(verified.retired, 'empty_unretired_plan');
    return { status: 'confirmed', cutoff: verified.block, broadcast: false };
  }
  if (!execute) return { status: 'preflight_passed', planDigest: plan.digest, steps: plan.steps.length, retired: verified.retired, broadcast: false };
  ensure(typeof runtime === 'function', 'runtime_missing');
  const result = await runtime({ steps: plan.steps, planDigest: plan.digest,
    assertPlan: predecessorRetirementValidator({ plan, deployment, artifacts, port }) });
  if (result.status !== 'confirmed') return result;
  const final = await verifyPredecessorRetirement({ plan, deployment, artifacts, port, complete: true });
  return { ...result, cutoff: final.block };
}
async function main() {
  const [command, path, ...flags] = process.argv.slice(2);
  if (command === '--help') {
    console.log('predecessor-retirement-cli.mjs prepare OUTPUT_JSON | inspect PLAN_JSON | run INPUTS_JSON [--execute] [--watch]\nNode20/tsx. prepare writes an exclusive private plan; inspect and run default are read-only. Inputs name planPath, approvedStageBudgetWei, maxFeePerGasWei, maxPriorityFeePerGasWei, maxGas and signerReferences (admin address -> op:// reference). --execute holds the old kernel/verifier and revokes their minter/approver; it changes public behavior and is subject to the public-switch hold. It does not deploy or publish a pointer, activate a successor, transfer balances or release clients. A confirmed result supplies the finalized retirement cutoff for the next snapshot.');
    return;
  }
  ensure(['prepare', 'inspect', 'run'].includes(command) && path, 'usage');
  ensure(flags.every(flag => ['--execute', '--watch'].includes(flag)) && new Set(flags).size === flags.length
    && (command === 'run' || flags.length === 0) && (!flags.includes('--watch') || flags.includes('--execute')), 'usage');
  const deployment = read(resolve(root, 'contracts/deployments/base-pvt9-institutions.json')), artifacts = readSuccessorArtifacts(root);
  const port = snapshotRpcPort([process.env.BASE_RPC_URL ?? 'https://base-rpc.publicnode.com', process.env.BASE_RPC_URL_SECONDARY ?? 'https://base.drpc.org']);
  if (command === 'prepare') {
    const plan = await preparePredecessorRetirement({ deployment, artifacts, port });
    writeFileSync(resolve(path), JSON.stringify(plan, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ status: 'prepared', planDigest: plan.digest, steps: plan.steps.length, broadcast: false })); return;
  }
  if (command === 'inspect') { console.log(JSON.stringify(await verifyPredecessorRetirement({ plan: read(path), deployment, artifacts, port }))); return; }
  const input = read(path), plan = read(input.planPath), execute = flags.includes('--execute');
  // The callback is lazy: neither Firestore nor 1Password is accessed during a
  // read-only run, and durable stage validation/fees precede key loading.
  const runtime = async stage => {
    ensure(process.env.GOOGLE_CLOUD_PROJECT === 'provian-ai' && process.env.FIRESTORE_DATABASE_ID === 'relay', 'database_selection');
    const positive = key => { ensure(typeof input[key] === 'string' && /^[1-9][0-9]*$/.test(input[key]), 'fee_configuration'); return BigInt(input[key]); };
    const maxFeePerGas = positive('maxFeePerGasWei'), maxPriorityFeePerGas = positive('maxPriorityFeePerGasWei'), maxGas = positive('maxGas');
    positive('approvedStageBudgetWei');
    ensure(typeof input.signerReferences?.[plan.state.admin] === 'string' && input.signerReferences[plan.state.admin].startsWith('op://'), 'signer_reference_missing');
    const loadSigner = async address => {
      ensure(address === plan.state.admin, 'signer_mismatch');
      let reply;
      try { reply = await exec('op', ['read', input.signerReferences[address]], { encoding: 'utf8', timeout: 30000, maxBuffer: 16384 }); }
      catch { throw Error('retirement_cli_key_unavailable'); }
      const key = reply.stdout.trim(); ensure(/^(?:0x)?[0-9a-fA-F]{64}$/.test(key), 'key_invalid');
      let signer;
      try { signer = new Wallet(key.startsWith('0x') ? key : '0x' + key); }
      catch { throw Error('retirement_cli_key_invalid'); }
      ensure(signer.address.toLowerCase() === address, 'signer_mismatch'); return signer;
    };
    return runChangeoverStage({ ...stage, db: scriptDb(), readers: port.rpcs, loadSigner,
      approvedStageBudgetWei: input.approvedStageBudgetWei, maxFeePerGas, maxPriorityFeePerGas, maxGas });
  };
  do {
    const result = await advancePredecessorRetirement({ plan, deployment, artifacts, port, execute, runtime });
    console.log(JSON.stringify(result));
    if (!flags.includes('--watch') || result.status === 'confirmed') return;
    await new Promise(resolve => setTimeout(resolve, 5000));
  } while (true);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(/^retirement_cli_[a-z_]+$/.test(error.message) ? error.message : 'retirement_cli_refused'); process.exitCode = 1; });
}
