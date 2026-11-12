#!/usr/bin/env -S tsx
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Interface, Wallet, sha256, toUtf8Bytes } from 'ethers';
import { scriptDb } from '../../provian-backend/scripts/lib/script-db.ts';
import { snapshotRpcPort } from './snapshot-cli.mjs';
import { preflightSuccessorPlan, readSuccessorArtifacts, verifySuccessorSourceInterval } from './successor-preflight.mjs';
import { verifyPermanentPointerPlan } from './permanent-pointer-plan.mjs';
import { batchSuccessorImports } from './successor-plan.mjs';
import { runChangeoverStage } from './changeover-runtime.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ensure = (value, reason) => { if (!value) throw Error('successor_deploy_' + reason); };
const read = file => JSON.parse(readFileSync(resolve(file), 'utf8'));
const exec = promisify(execFile);

export function successorDeploymentSteps(plan, artifacts, batchSize, maximum) {
  ensure(plan.creations.length === 12 && plan.configuration.length > 0, 'empty_stage');
  ensure(Number.isSafeInteger(batchSize) && batchSize >= 1 && batchSize <= 128, 'batch_size');
  return structuredClone([...plan.creations,
    ...batchSuccessorImports(plan, artifacts, batchSize, maximum), ...plan.economicImports, ...plan.custodyImports, ...plan.configuration]);
}
export function successorDeploymentValidator({ plan, pointerPlan, deployment, artifacts, port, steps }) {
  plan = structuredClone(plan); steps = structuredClone(steps);
  pointerPlan = structuredClone(pointerPlan); deployment = structuredClone(deployment);
  ensure(plan.pointer === pointerPlan.pointer && plan.pointerAuthority === pointerPlan.authority, 'pointer_changed');
  const digest = sha256(toUtf8Bytes(JSON.stringify({ planDigest: plan.digest, steps })));
  return async checked => {
    ensure(checked.planDigest === plan.digest && checked.stageDigest === digest
      && JSON.stringify(checked.steps) === JSON.stringify(steps), 'stage_changed');
    // Runtime/authority checks also refuse publication racing this held stage.
    const pointer = await verifyPermanentPointerPlan(pointerPlan, port);
    ensure(pointer.states.every(state => state === 'deployed'), 'pointer_not_deployed');
    const current = pointer.block;
    ensure(current.number >= plan.cutoff.number, 'finality_regressed');
    const kernel = new Interface(artifacts.ProvianPVT9.abi);
    for (const [method, expected] of [['administrativeHold', true], ['operationalMinter', '0x' + '00'.repeat(20)]]) {
      ensure(kernel.decodeFunctionResult(method, await port.call(plan.predecessor,
        kernel.encodeFunctionData(method), current.hash))[0] === expected, 'predecessor_reactivated');
    }
    await verifySuccessorSourceInterval({ plan, deployment, artifacts, port, current });
    ensure(await port.blockHash(plan.cutoff.number) === plan.cutoff.hash
      && await port.blockHash(current.number) === current.hash, 'reorg');
  };
}

async function main() {
  const [inputPath, ...flags] = process.argv.slice(2);
  if (inputPath === '--help') {
    console.log('successor-deploy-cli.mjs INPUTS_JSON [--execute] [--watch]\nRequires the repository Node20 runtime. Run with provian-backend/node_modules/.bin/tsx. Inputs name planPath, pointerPlanPath, signedRulePath, operatorsPath, importBatchSize, approvedStageBudgetWei, maxFeePerGasWei, maxPriorityFeePerGasWei, maxGas and signerReferences (address -> op:// reference). Default performs read-only preflight. --execute deploys/imports/configures the reviewed successor set using durable journals; it does not retire the predecessor, deploy/publish the pointer, activate the kernel or release clients. The predecessor must already be retired and the permanent pointer deployed but unpublished. --watch requires --execute. Public switch authorization remains a separate operator instruction.');
    return;
  }
  ensure(inputPath && flags.every(flag => ['--execute', '--watch'].includes(flag))
    && new Set(flags).size === flags.length, 'usage');
  const execute = flags.includes('--execute'), watch = flags.includes('--watch');
  ensure(!watch || execute, 'watch_requires_execution');
  const input = read(inputPath), temporary = mkdtempSync(join(tmpdir(), 'provian-successor-rule-'));
  let verifiedRule;
  try {
    const output = join(temporary, 'verified.json');
    await exec(resolve(root, 'provian-backend/node_modules/.bin/tsx'),
      [resolve(root, 'provian-backend/scripts/recourse-membership-rule.ts'), 'verify-signed', resolve(input.signedRulePath), output],
      { cwd: root, timeout: 30000, maxBuffer: 16384 });
    verifiedRule = read(output);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  const port = snapshotRpcPort([process.env.BASE_RPC_URL ?? 'https://base-rpc.publicnode.com',
    process.env.BASE_RPC_URL_SECONDARY ?? 'https://base.drpc.org']);
  const deployment = read(resolve(root, 'contracts/deployments/base-pvt9-institutions.json'));
  const artifacts = readSuccessorArtifacts(root), pointerPlan = read(input.pointerPlanPath);
  const preflight = await preflightSuccessorPlan({ plan: read(input.planPath), pointerPlan, verifiedRule,
    operators: read(input.operatorsPath), deployment, artifacts, port });
  const steps = successorDeploymentSteps(preflight.plan, artifacts, input.importBatchSize, input.executionLimits?.maxGas);
  const assertPlan = successorDeploymentValidator({ plan: preflight.plan, pointerPlan, deployment, artifacts, port, steps });
  if (!execute) {
    console.log(JSON.stringify({ result: 'preflight_passed', planDigest: preflight.plan.digest, steps: steps.length,
      ...preflight.facts, broadcast: false })); return;
  }
  // Never silently create operator reservations in a different Firestore DB.
  ensure(process.env.GOOGLE_CLOUD_PROJECT === 'provian-ai' && process.env.FIRESTORE_DATABASE_ID === 'relay', 'database_selection');
  const positive = key => {
    ensure(typeof input[key] === 'string' && /^[1-9][0-9]*$/.test(input[key]), 'fee_configuration');
    return BigInt(input[key]);
  };
  const maxFeePerGas = positive('maxFeePerGasWei'), maxPriorityFeePerGas = positive('maxPriorityFeePerGasWei'), maxGas = positive('maxGas');
  positive('approvedStageBudgetWei');
  ensure(input.signerReferences && typeof input.signerReferences === 'object' && !Array.isArray(input.signerReferences), 'signer_references');
  for (const address of new Set(steps.map(step => step.from))) ensure(typeof input.signerReferences[address] === 'string'
    && input.signerReferences[address].startsWith('op://'), 'signer_reference_missing');
  const loadSigner = async address => {
    let value;
    try { value = await exec('op', ['read', input.signerReferences[address]], { encoding: 'utf8', timeout: 30000, maxBuffer: 16384 }); }
    catch { throw Error('successor_deploy_key_unavailable'); }
    const key = value.stdout.trim();
    ensure(/^(?:0x)?[0-9a-fA-F]{64}$/.test(key), 'key_invalid');
    const signer = new Wallet(key.startsWith('0x') ? key : '0x' + key);
    ensure(signer.address.toLowerCase() === address, 'key_address_mismatch');
    return signer;
  };
  const db = scriptDb();
  do {
    const result = await runChangeoverStage({ db, steps, planDigest: preflight.plan.digest, readers: port.rpcs,
      loadSigner, assertPlan, approvedStageBudgetWei: input.approvedStageBudgetWei, maxFeePerGas, maxPriorityFeePerGas, maxGas });
    console.log(JSON.stringify(result));
    if (result.status === 'confirmed' || !watch) return;
    await new Promise(resolve => setTimeout(resolve, 5000));
  } while (true);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(/^successor_deploy_[a-z_]+$/.test(error.message)
    ? error.message : 'successor_deploy_refused'); process.exitCode = 1; });
}
