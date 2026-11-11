#!/usr/bin/env -S tsx
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Wallet } from 'ethers';
import { scriptDb } from '../../provian-backend/scripts/lib/script-db.ts';
import { snapshotRpcPort } from './snapshot-cli.mjs';
import { preparePointerDeployment, verifyPointerDeployment, advancePointerDeployment } from './pointer-deployment.mjs';
import { runChangeoverStage } from './changeover-runtime.mjs';
const ensure = (value, reason) => { if (!value) throw Error('pointer_deploy_cli_' + reason); };
const read = path => JSON.parse(readFileSync(resolve(path), 'utf8'));
const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
async function main() {
  const [command, path, ...flags] = process.argv.slice(2);
  if (command === '--help') {
    console.log('pointer-deployment-cli.mjs prepare INPUTS_JSON OUTPUT_JSON | inspect PLAN_JSON | run INPUTS_JSON [--execute] [--watch]\nNode20/tsx. Preparation inputs name pointerPlanPath and deployer. Run inputs name planPath, approvedStageBudgetWei, maxFeePerGasWei, maxPriorityFeePerGasWei, maxGas and signerReferences (deployer -> op:// reference). Default is read-only. --execute deploys the independently hash-authorized permanent pointer at its fixed CREATE2 address using durable journals. It never publishes components, retires contracts, activates issuance or releases clients. Public-switch hold remains applicable; no deployment is implied by preparation.');
    return;
  }
  ensure(path && ['prepare', 'inspect', 'run'].includes(command), 'usage');
  ensure(command === 'prepare' ? flags.length === 1 && !flags[0].startsWith('--') : flags.every(flag => ['--execute', '--watch'].includes(flag))
    && new Set(flags).size === flags.length && (command === 'run' || flags.length === 0)
    && (!flags.includes('--watch') || flags.includes('--execute')), 'usage');
  const pin = read(resolve(root, 'config/protocol-pointer.json'));
  const port = snapshotRpcPort([process.env.BASE_RPC_URL ?? 'https://base-rpc.publicnode.com', process.env.BASE_RPC_URL_SECONDARY ?? 'https://base.drpc.org']);
  if (command === 'prepare') {
    const input = read(path), plan = await preparePointerDeployment({ pointerPlan: read(input.pointerPlanPath), deployer: input.deployer, port, pin });
    writeFileSync(resolve(flags[0]), JSON.stringify(plan, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ status: 'prepared', planDigest: plan.digest, steps: plan.steps.length, pointer: plan.pointerPlan.pointer, broadcast: false })); return;
  }
  if (command === 'inspect') { console.log(JSON.stringify(await verifyPointerDeployment({ plan: read(path), port, pin }))); return; }
  const input = read(path), plan = read(input.planPath), execute = flags.includes('--execute');
  const runtime = async stage => {
    ensure(process.env.GOOGLE_CLOUD_PROJECT === 'provian-ai' && process.env.FIRESTORE_DATABASE_ID === 'relay', 'database_selection');
    const positive = key => { ensure(typeof input[key] === 'string' && /^[1-9][0-9]*$/.test(input[key]), 'fee_configuration'); return BigInt(input[key]); };
    const maxFeePerGas = positive('maxFeePerGasWei'), maxPriorityFeePerGas = positive('maxPriorityFeePerGasWei'), maxGas = positive('maxGas');
    positive('approvedStageBudgetWei');
    ensure(typeof input.signerReferences?.[plan.deployer] === 'string' && input.signerReferences[plan.deployer].startsWith('op://'), 'signer_reference_missing');
    const loadSigner = async address => {
      ensure(address === plan.deployer, 'signer_mismatch');
      let reply;
      try { reply = await exec('op', ['read', input.signerReferences[address]], { encoding: 'utf8', timeout: 30000, maxBuffer: 16384 }); }
      catch { throw Error('pointer_deploy_cli_key_unavailable'); }
      const key = reply.stdout.trim(); ensure(/^(?:0x)?[0-9a-fA-F]{64}$/.test(key), 'key_invalid');
      let signer;
      try { signer = new Wallet(key.startsWith('0x') ? key : '0x' + key); }
      catch { throw Error('pointer_deploy_cli_key_invalid'); }
      ensure(signer.address.toLowerCase() === address, 'signer_mismatch'); return signer;
    };
    return runChangeoverStage({ ...stage, db: scriptDb(), readers: port.rpcs, loadSigner,
      approvedStageBudgetWei: input.approvedStageBudgetWei, maxFeePerGas, maxPriorityFeePerGas, maxGas });
  };
  do {
    const result = await advancePointerDeployment({ plan, port, pin, execute, runtime }); console.log(JSON.stringify(result));
    if (!flags.includes('--watch') || result.status === 'confirmed') return;
    await new Promise(resolve => setTimeout(resolve, 5000));
  } while (true);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(/^pointer_deploy_cli_[a-z_]+$/.test(error.message) ? error.message : 'pointer_deploy_cli_refused'); process.exitCode = 1; });
}
